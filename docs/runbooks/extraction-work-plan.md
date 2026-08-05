# The extraction — what to do, in order

**Owner decision, this session: data extraction goes first.** This is the work plan for that.

`legacy-self-extraction.md` is the reference — the *why*, and the rules the software enforces.
This page is the *what*, in sequence, with what you need for each step and what "done" looks
like. Work down it. Nothing here needs the old vendor, and nothing here interrupts trading.

---

## Before anything: the two things that unblock everything else

**1. Find whoever installed your current system.** Not the vendor's support desk — the person or
local firm who set it up. They usually know where the data sits on the back-office PC and what
the password is, and they have no reason not to say. One phone call, and it decides whether you
get Route A (everything, including history) or Route C (totals only).

**2. Ask your CA for one list.** Specifically: *"which balances in our accounts came from your
journals rather than from our system?"* That is the depreciation, provisions, accruals and
drawings list. It exists nowhere else, no export will ever contain it, and its absence is exactly
what makes opening books fail to balance. It is a five-minute question and the answer is the
single most valuable document in this whole exercise.

Neither costs money. Both can start today.

---

## Step 1 — Copy before you read (MG-02)

Whatever route you use, take an **untouched copy first**, before anything reads the data. Then
work from the copy.

This is not a formality: the first thing that reads the data must not also be the only thing that
has it. If the database is locked while the program is running, close the program on every
machine first, or do it after the shop closes.

**Done when:** there is a copy on a separate drive that nobody has opened.

---

## Step 2 — Count everything, on the screen, before exporting

For every screen you are about to export, **read the row count off the screen and write it
down.** Products, customers, suppliers, stock lines.

One glance each. It is the strongest check that exists, and it is the only one that does not
depend on the exported file being honest about itself.

**Done when:** you have a piece of paper with a number against each thing you will export.

---

## Step 3 — Export, and check each file as it comes out

For each file, run:

```
node --experimental-strip-types scripts/extract-check.mts <file> \
  --column "Item Code" --rows <the number you wrote down>
```

Replace `"Item Code"` with any column name you can see in the file — it uses that to find the
real header underneath the shop name and the report title.

**What you will see.** One of three things:

| It says | It means | Do this |
| --- | --- | --- |
| **USABLE** | The file is whole and readable | Move on to the next one |
| **REFUSED** | It is short — usually one page of many | Export again with **no filter and no page limit** |
| **COULD NOT READ** | The header was not found | Try a different `--column`, or `--sep "\t"` for tab files |

**Do not argue with a REFUSED.** It is the one failure that looks completely fine: a short file
parses cleanly, its rows are well formed, and its own total agrees with the sum of its rows to
the paisa. It is internally consistent about a shop a fraction of the real size, and the first
person to notice is a customer whose item will not scan.

**Done when:** every file says USABLE, and the row count in each matches your paper.

---

## Step 4 — Gather the outside evidence

This is the part that decides whether the migration can be signed, and **it is entirely yours to
collect.** None of it involves the old vendor and nobody will refuse you any of it.

| Get | From | Covering | Note |
| --- | --- | --- | --- |
| **Bank statements** | Your bank | The whole period **and a week or two past the end** | The last week's card money lands after the period closes. A statement ending on your last trading day is missing the money it exists to prove |
| **GST returns** | The GST portal, yourself | Every month being migrated | Download the PDFs — the acknowledgement number is on them, and without it the software will not use the file |
| **Supplier statements** | Every supplier | As at one chosen date | Ask **all** of them, not just the big ones. A supplier who does not reply is recorded by name as unproved |
| **Signed accounts** | Your CA | The last completed year | Signed, not draft. Plus the journals-only list from the top of this page |
| **The card commission** | Your card machine agreement | — | The actual percentage, from the paper. Without it the bank check refuses to run, deliberately |
| **A stock count** | Your own shelves | One closed evening | See below |

**About the stock count.** It does **not** have to be a full count. The software plans a
value-weighted one: the high-value lines — the ghee, the oil, the big rice bags — are counted in
**full**, and a thin sample is taken from everything else. That covers about 80% of your money in
a fraction of the hours.

Three things it insists on, and each matters:
- The counter **never sees the expected number**. Shown "expected: 40", people write 40.
- Whoever ran the extraction **cannot choose which lines get checked**. Not dishonesty — you pick
  the lines you are confident about, and that is what confidence does.
- What the sample suggests about the uncounted rest is reported as an **estimate**, never added
  to the counted figure to make one confident-looking total.

**Done when:** all six are on the table, and the count is booked.

---

## Step 5 — Load into the rehearsal environment, never production

The software refuses a production target before it checks anything else, on every request. That
is hard rule #7 and it is not adjustable.

**Done when:** the trial load runs end to end and produces its exception list.

---

## Step 6 — Reconcile against the outside evidence, not against the old system

Six checks, each against a record somebody outside your old system keeps:

- **Stock** → the shelves
- **Suppliers** → their own statements
- **Sales** → the bank
- **Tax** → the filed returns
- **Books** → your CA's signed accounts
- **Loyalty** → a sample of customers, drawn **before** anybody is told anything

**Done when:** the verification report renders. It will not render until all twelve areas have an
answer — a report over some of them looks completely finished and is not.

---

## Step 7 — Work the exception list, then sign

Every problem found is kept. You decide each blocking one, **including deciding to accept it** —
one at a time, by name, in your own words. "Approved" and "as discussed" are refused as reasons,
because in two years that sentence is the only record that you understood what was being carried.

You will find something. The list should be short, named, and in writing.

**Done when:** you and your CA have signed the page, and it says what could not be proved.

---

## What you should refuse to accept, at any point

- *"The stock figure was checked against the valuation report."* That is the same system
  agreeing with itself. It would agree just as perfectly about a wrong number.
- *"We worked out the card commission from the difference."* Then every shortfall is commission
  by definition, and the check proves nothing. The software refuses that by name.
- *"We put the difference in a suspense account."* The books then balance and are wrong, and that
  account is never cleared. Refused by name, before the balance is even checked.
- *"It's only a few products missing."* Ask how many, against the number on your paper.

---

## Related

- `cutover-weekend.md` — the weekend itself, hour by hour, and when to stop and go back
- `legacy-self-extraction.md` — the reference: routes, evidence, and why each rule exists
- `../evidence/example-verification-report.md` — the page you will sign, worked through
- `../evidence/ob-06-every-figure-has-a-witness.md` — the gate proving every area has a witness
