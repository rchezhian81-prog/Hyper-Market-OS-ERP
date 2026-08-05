# OB-06 gate evidence — we get it out ourselves

**Gate:** owner decision OB-06, 7 August 2026. **MG-01, MG-02, MG-05, MG-06**, §34, §29.1, hard
rules #2, #6, #7.

**Executed:** 7 August 2026 against **PostgreSQL 16.13**. Automated as
`tests/integration/we-get-it-out-ourselves.test.ts` (16 assertions) plus 41 unit assertions
across `migration-extraction`, `migration-report-parser` and `migration-render-report`. Full
suite 2,489.

The claim on trial: **we can get our own data out, prove it is right, and open the new system on
it — without the incumbent vendor's cooperation, and without touching their software.**

---

## The decision this rests on

The owner's words, 7 August 2026: *"who will give this? no one will be ready to, because they
don't want to lose a customer. Please stop asking — we have to migrate ourselves."*

That is the correct reading, and it should not have taken the owner to reach it. A vendor asked
to export a customer's data in an open format is being asked to help that customer leave. The
request is answered slowly, partially, in a format nobody can use, or not at all — and none of
those is a refusal you can escalate. **A plan whose first step is "wait for them" has handed its
schedule to somebody whose interests run the other way.**

**EX-02 is closed.** The drafted letter stays on file. If they ever answer, it is a bonus.

---

## What changes, and what does not

**The engine does not change.** Stage 11 proved MG-01…MG-12 end to end, and that work stands.
What changes is the **shape the data arrives in** and, far more importantly, **where the proof
comes from**.

| | With a vendor export | Extracting ourselves |
|---|---|---|
| Shape | Clean rows in a documented format | A printed page in a spreadsheet |
| Completeness | Whatever they chose to include | Whatever the route can structurally yield — stated up front |
| **Proof** | **Their word for what it means** | **The bank, the filed returns, the supplier, and our own shelves** |

The third row is the one that matters, and it runs the opposite way to expectation.

---

## Part 1 — the route is judged before it is used

| # | What happens | Control proven |
|---|---|---|
| 1 | A printed stock report is offered as a source | **Accepted**, with what it cannot give named up front: batch code, expiry date, and **stock location** |
| 2 | The location gap | Found by writing the integration test, not by reasoning: two rows for one product, shop floor and back store, arrive as one figure. Route C cannot break them out, so opening state built from it is **product-level, deliberately** |
| 3 | A re-keyed table offered as a migration source | **Refused.** Not snobbery about manual work — a route nobody can re-run cannot be rehearsed (MG-05), cannot be delta'd (MG-09) and cannot be redone when the first load is wrong |
| 4 | The four routes | Ranked by what they **structurally** lose. A printed report has already grouped, rounded and omitted; parsing recovers what it printed, never what it did not |

## Part 2 — seal before reading (MG-02)

| # | What happens | Control proven |
|---|---|---|
| 5 | The printed file is sealed before anything parses it | The first thing that reads the data must not also be the only thing that has it |
| 6 | One figure edited afterwards | **Digest mismatch** |

## Part 3 — the parse, against ground truth

This is the check a real file can never give: **we generated the data, so we know the answer.**

| # | What happens | Control proven |
|---|---|---|
| 7 | A known dataset is rendered as a printed report — banner, page breaks, repeated headers, five department subtotals, a grand total, a print stamp | 526 printed lines carrying 396 stock rows |
| 8 | Parsed back and compared to the dataset that went in | **Lossless.** Every row and every paisa, through every page break |
| 9 | Repeated at page sizes 7, 13, 25, 60 and 500 | **Lossless at all of them.** A break landing between a row and its subtotal is the case that breaks naive parsers, so it is exercised where it actually falls rather than at one convenient size |
| 10 | The header | **Found**, not assumed to be line 1 — taking the first line names the columns after the shop |
| 11 | *"Total for GROCERY"* | **Never counted as a product.** Counted as one, it adds the group's total back into the group and doubles it — plausibly wrong rather than obviously wrong |
| 12 | Every line not taken | **Accounted for**, including the banner *above* the header. *"Where did the other four hundred rows go"* is asked about the file, not about the part below the header |
| 13 | The round-trip check itself | **Fires on all four ways a parse loses data** — a dropped row, a subtotal counted as data, a lost second location hiding behind a still-present id, and a misread figure with every row present |

### The four things that would corrupt it silently

| | Handled by |
|---|---|
| **`4,12,000.00` is twelve lakh, not four thousand** | Separators dropped, never validated against one convention. A parser that "corrects" Indian grouping multiplies a valuation by a factor nobody notices until an audit |
| **`parseFloat(x) * 100` is wrong, always** | The decimal is parsed **as text**. 19.99 × 100 is 1998.9999999999998 in every language with binary floats. There is no float in the file (§29.1) |
| **`CR` is negative** | A credit read positive inverts every supplier balance and reconciles to exactly twice the truth |
| **A lone `-` is nil** | A *number*, which these reports print constantly — not a blank, and not a silent zero |

## Part 4 — the control the whole approach rests on

| # | What happens | Control proven |
|---|---|---|
| 14 | Stock verified against another report from the same product | **Refused by name** — *"just as consistent about a wrong number"*, and it says which outside evidence to go and get |
| 15 | A control total whose two sides both came off the report | **Refused** (`same_derivation_both_sides`) |
| 16 | Stock verified against a **physical count** | **Accepted.** The only truth about stock that exists anywhere; everything else is a record *of* it |
| 17 | The total signed by the person who ran the load | **Refused** (§28) |
| 18 | Signed by somebody else | **QG-07 passes** |
| 19 | Opening state built before QG-07 | **Refused** |
| 20 | Opening state after | **Banked as append-only events** in PostgreSQL; `UPDATE` and `DELETE` refused by the database itself |
| 21 | The whole path | Ran **from a file**. No connection to the incumbent, no source code, nothing defeated — asserted by absence |

---

## Why this is better evidence, not worse

The expectation is that losing the vendor export weakens the migration. It does the opposite,
and the reason is precise:

**A vendor export is one system's account of itself. A bank statement is an adversary's.**

With a vendor file, the temptation is to trust it — it looks authoritative, it is in a clean
format, and the natural check is against another figure from the same source. That check always
passes. Without the file, there is nothing to check against except records **other people keep,
for their own reasons**:

| To prove | Against | Why it is independent |
|---|---|---|
| Stock | A physical count | Nobody's record. The shelves |
| Sales | Bank statement, settlement file | The bank has no interest in agreeing with our old system |
| Tax | GST returns already filed | Filed, dated, signed — it cannot be adjusted to make a total agree |
| Supplier balances | The supplier's own statement | They keep their own ledger and will confirm it, because they want paying |
| Books | The accounts the CA prepared | Prepared independently, by somebody with a licence at stake |

## What is not proved here

- **The real fault profile.** The ten kinds of damage in the fixture are drawn from what these
  systems contain; the incumbent will have its own proportions and may have a kind nobody
  predicted. The pipeline surfaces an unforeseen kind as an **exception rather than a silent
  default**, which is the property that had to be settled before the data arrives.
- **The real volume**, and therefore the true extraction window.
- **Which route each domain will actually take.** That depends on what is found on the back-office
  machine, and the runbook is ordered so the best available route is used per domain.

## What the owner should check in the store

1. **Ask what the stock figure was checked against.** The right answer is *"a physical count."*
   If the answer is another report from the old system, it has not been checked.
2. **Ask to see the list of lines the software skipped** when reading a report. Every one, with a
   reason. If it cannot produce that list, it is guessing.
3. **Ask how many rows the screen said, and how many came out.** Two numbers that match. A file
   with 4,000 rows where the screen said 41,200 is not a smaller export — it is the wrong file.
4. **Ask what the printed report cannot tell us.** Batch, expiry and location. That is a real
   limit of that route, stated rather than discovered at cutover.

## Verdict

**OB-06 gate: PASSED.** The data can be got out, read exactly, proved against evidence from
outside the incumbent entirely, and banked as opening truth — with no vendor cooperation, and
with their software untouched. The shop trades on the old system throughout.
