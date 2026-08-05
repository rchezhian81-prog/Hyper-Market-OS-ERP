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
| **Sales** | The bank statement; the card/UPI settlement file | The bank has no interest in agreeing with our old system (see below — the hardest of the six) |
| **Tax** | The GST returns already filed | Filed, dated, signed. It cannot be adjusted to make a total agree — so where the books disagree, the books are wrong (see below) |
| **Supplier balances** | The supplier's own statement | They keep their own ledger and will confirm it, because they want paying — no goodwill required (see below) |
| **Books** | The accounts the CA prepared | A professional signature and double entry — but prepared **from the same old system**, so the weakest of the six (see below) |
| **Loyalty points** | A sample of customers | They can see their own balance and will say if it is wrong |

**A vendor export is one system's account of itself. A bank statement is an adversary's.** The
second is better evidence.

Where a domain has *no* outside check available, that is not a reason to stop — but it is written
down, and the owner is told in writing that those figures rest on the old system's word.

### Supplier statements — the one that costs nothing to get

Ask each supplier for a statement of account as at a chosen date. **This needs nobody's goodwill.**
A supplier sending you a list of what you owe them is a supplier chasing money; it is the one
request in this whole exercise that gets answered promptly.

Expect the two ledgers **not** to agree, and expect that to be nobody's fault:

> Their statement says we owe 8,40,000. Our books say we owe 7,95,000.
> Neither is wrong. We paid 45,000 on the 29th; they banked it on the 2nd.

That is a **timing difference** and it clears by itself. A **real difference** does not. Telling
them apart is the whole job, and three things the software will not do:

- **It never nets.** *"They say we owe 45,000 more"* and *"we paid 45,000 they have not applied"*
  might be one event or two separate problems. Offset, they make a clean zero that hides both, so
  they are always listed separately.
- **It never calls a disputed amount timing.** If both sides have the same invoice at different
  amounts, nobody is waiting for the post — it is a price, a quantity or a tax the two of you read
  differently, and it is settled against the delivery note.
- **It treats an invoice you have never seen as the serious one**, and puts it at the top of the
  list. Everything else is a difference you would find; this one you would not. Migrated as it
  stands you open owing **nothing** for a real bill, and the first you hear of it is when they
  chase — by which time it is in the signed opening balance. Overstating what you owe gets caught
  by you. Understating it gets caught by nobody.

**A supplier who never replies is listed by name as unverified.** Silence is the commonest reply
to a statement request and the easiest to read as agreement — and the balance it leaves unproved
goes into the opening books either way.

### Sales against the bank — the hardest of the six

Get the bank statements for the period. Then expect the thing everybody expects: **the sales
figure will not equal the bank figure, and it never will.** The money changes on the way:

- **Cash** goes in at the bank in lumps, days later, after the float and the till change come out.
- **Card** arrives **net of the provider's commission** and the GST charged on that commission.
- **UPI** arrives in full, but on its own cycle.

So the check does not compare two totals — it reconstructs the route, and the danger is that
everyone already knows the two will not agree. **An explicable difference you see every day is
the perfect hiding place for a real one.**

The one thing that matters more than any other here: **the commission rate must come off the
merchant agreement, the provider's advice or the bank's confirmation — never from the gap it is
meant to explain.** Work it out backwards from the difference and every shortfall becomes
commission by definition; the reconciliation then agrees perfectly at any figure and has proved
absolutely nothing. The software refuses that rate by name, and there is a test showing a
₹60,000 hole reconciling to a clean zero under a rate fitted to it.

**Cash is the one to watch.** Card and UPI move themselves; nobody carries them. Cash is the only
tender a person physically holds between the till and the bank — and unlike a supplier balance,
**there is no counterparty who will ever chase it.** So cash taken and not lodged is reported on
its own figure, never merged into a tender total, with the most cash standing unlodged at any
point shown beside it. Some of that is float and till change. The rest needs a name against it.

Two more things the software insists on:

- **A credit you cannot explain is not a bonus.** Money arriving with no sale behind it is usually
  somebody else's — a mis-posted transfer that comes back out. Migrated as revenue it overstates
  your turnover **and the tax due on it**, and the correction arrives after the return is filed.
- **Ask the bank for a statement that runs past the period end.** A statement ending on the last
  trading day looks like a perfectly matched pair of dates, and the last day's card batch settles
  after it stops — so the money it exists to prove is not in it.

**What this check cannot do**, and it is written into the code as a fixed `false`: the bank shows
what *arrived*. A sale rung up and pocketed at the till reaches neither the old system nor the
bank, and the two agree perfectly about it. Only the stock count speaks to that.

### Tax against the returns you have already filed

Download GSTR-1 and GSTR-3B for every period being migrated from the GST portal. **They are
yours, they are already filed, and nobody has to agree to give them to you.**

This check works the opposite way round from every other one. Everywhere else we are asking
whether the extracted figure is right. Here the return is **already true as a matter of law** — it
was filed, dated and acknowledged, and it cannot be un-filed or adjusted to make a total come out.
So the question is not *"does the return agree with our books?"* but **"what do our books have to
become?"** Where they disagree, it is the books that are wrong.

Four things the software will not accept as a filed return:

- **One with no acknowledgement number.** A spreadsheet called `GSTR1_April.xlsx` is a working
  paper. The acknowledgement (ARN) is the only thing separating what was *filed* from what
  somebody *prepared* — and those differ exactly when it matters.
- **A part month.** A return covers a whole month and cannot be cut at a cutover date. A part
  period compared against a whole return is short by design, and it looks like missing sales.
- **One that a later month amended.** Amendments restate an earlier month. Reconciling to the
  superseded original gives a wrong answer with a perfect audit trail behind it.
- **One whose own arithmetic does not hold** — where the tax does not follow from the taxable
  value at its own rate. Either the typing is wrong or the return is, and using it would spread
  the error through every opening figure.

**And never an average rate.** You sell at 0%, 5%, 12% and 18% in the same basket. Multiply your
total sales by an average and the answer looks close enough to pass a glance, is wrong on every
line, and is wrong in **the one way the department checks automatically** — GST returns are
reconciled rate by rate, not in total. The software refuses a line at a rate nothing could
actually have been sold at, because that is what an average looks like.

It also checks **GSTR-1 against GSTR-3B**. The department compares those two by machine, so a
difference between them is a notice waiting to happen. If one is already there, we **inherited**
it — the migration did not create it — and you are told so in writing either way.

One rule with no exception: **a difference against a filed return goes to your CA, in writing,
before the opening books are signed.** Somebody signed that return. Quietly adjusting our figures
to meet it is not ours to do.

**What this cannot prove:** the return shows what was **declared**, never what was correctly
**charged**. If a product was sold at 5% when it should have been 12%, the return says 5%, the
books say 5%, and they agree perfectly. That is a question for the CA and the product master, not
for this check.

### The accounts your CA prepared — the one that ties the rest together

Ask your CA for the **signed** accounts for the last completed year. That closing balance sheet
**is** your opening position: stock, debtors, creditors, cash and tax all appear on it, and each
one has already been proved by its own evidence above. If the new books agree with it line by
line, everything else has agreed too.

Worth being straight about one thing: **this is the weakest of the six as outside evidence.** The
bank is an adversary's record; a supplier's statement is a counterparty's; a count is the shelves
themselves. Your CA prepared these accounts *from the same old system we are leaving*. What they
add is not an independent source — it is **a professional signature and the discipline of double
entry**. That is a different kind of strength, and it does not replace the other five.

**The one thing this exists to stop.** When an opening trial balance does not balance, the
universal move in this industry is to post the difference to an account called *Suspense*, or
*Opening Difference*, or *Diff A/c*, and open anyway. The books then balance **perfectly** and are
wrong. And that account is never cleared — it is still sitting there in five years, and by then
nobody alive knows what it was. **The software refuses it by name**, and refuses it *before* it
checks whether the books balance, so a set of books that only closes because of the plug is never
reported as balancing. If the books do not balance, the number has to be found.

Three more refusals, each a real trap:

- **Draft accounts are not accounts.** Unsigned figures still change, and the whole reason to
  reconcile to your CA's numbers is that somebody with a licence at stake has put their name and
  membership number to them.
- **The accounts must end the day before the books open.** A signed balance sheet is a position at
  one instant. If you cut over a month later, everything traded in between is missing from it —
  and the opening is out by a whole trading period while looking completely authoritative.
- **What only the CA has must arrive.** Depreciation, provisions, accruals, prepayments, drawings
  and the year-end journals exist **only** in your CA's books. No export from the old system will
  ever contain them. Leave them out and the books open short by exactly their value — which is
  precisely the difference that then gets posted to Suspense.

One softer check: a balance sitting on the side you would not expect — a bank account in credit,
say — is **flagged for a sentence of explanation, not rejected.** Sometimes it is right (the
account really was overdrawn) and sometimes it is a sign read backwards on the way in. Accounts
that always sit the other way round on purpose — drawings, accumulated depreciation — are known
about, so the flag stays rare enough to be worth reading.

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
   Ask **every** supplier, not only the big ones — a supplier who does not reply is recorded as
   unverified by name, and a small balance nobody confirmed is still a balance nobody confirmed.
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
- **Ask which suppliers confirmed their balance, and which never replied.** The second list should
  be short, and it should be a list of names — not a number.
- **Ask how many rows came out, and how many went in.** Two numbers that match, per table.
- **Ask to see the list of what could not be proved.** There will be something. It should be
  short, named, and in writing.

## Related

- `../architecture/migration-design.md` — the MG-01…12 pipeline this feeds
- `../evidence/stage-11-the-old-shop-arrives-whole.md` — the engine, rehearsed end to end
- `../discovery/legacy-data-access.md` — the vendor letter, retained on file, no longer the plan
- `../../packages/migration/src/extraction.ts` — the route and verification rules, as code
- `../../packages/migration/src/supplier-reconciliation.ts` — the supplier statement check: timing
  told from real, nothing netted, and the invoice we have never seen sorted to the top
- `../../packages/migration/src/banking-verification.ts` — sales against the bank: the route
  reconstructed rather than compared, a commission rate refused if it was derived from the gap it
  explains, and cash reported on its own figure
- `../../packages/migration/src/tax-verification.ts` — tax against the filed returns: the
  acknowledgement number as the thing that makes a return evidence, slab by slab with no average
  rate available anywhere, and a difference treated as a disclosure rather than a fix
- `../../packages/migration/src/books-verification.ts` — the opening books against the signed
  accounts: Suspense refused by name and refused before the balance test, and the CA-only
  balances treated as a precondition rather than a variance
- `../../packages/migration/src/report-parser.ts` — reads what Routes B and C actually produce:
  finds the real header under the shop's name and the report title, never counts a
  *"Total for GROCERY"* line as a product, reads `4,12,000.00` as twelve lakh, and keeps every
  paisa exact
