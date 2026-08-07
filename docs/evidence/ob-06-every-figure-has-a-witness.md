# OB-06 verification gate — every figure has a witness

**Passed 7 August 2026.** `tests/integration/every-figure-has-a-witness.test.ts`, 16 assertions,
real PostgreSQL 16.13, green on three consecutive runs. Full suite **2,648 across 189 files**.

---

## What was being proved

OB-06 decided we extract our own data rather than wait for the incumbent vendor. The consequence
was not about access — it was about **verification**. Without a vendor file, everything comes from
the same place, and `extraction.ts` already refuses a domain checked only against the system it
came from. So every opening figure needs a witness outside the old ERP.

Six checks were built, one per domain family, each proved on its own. This gate asks the two
questions no unit test can:

1. **Does every domain actually have a witness with code behind it?**
2. **Do the witnesses agree with each other?**

---

## 1. No domain without a witness, no witness without a module

The test walks `VERIFIES` for all twelve domains and, for every external source named, requires a
module that consumes it:

| Evidence | Module |
| --- | --- |
| `physical_count` | `count-verification.ts` |
| `supplier_statement` | `supplier-reconciliation.ts` |
| `bank_statement`, `payment_settlement` | `banking-verification.ts` |
| `filed_gst_return` | `tax-verification.ts` |
| `ca_prepared_accounts` | `books-verification.ts` |
| `customer_confirmation` | `loyalty-verification.ts` |

**The failure this catches is a domain with a named witness and no code behind it** — a row in a
plan that reads as covered and is not. It is what a migration under time pressure produces, and
nobody notices until the CA asks what the figure was checked against.

The map is typed `Record<ExternalSource, string>`, so the gate is enforced by the **compiler**:
adding a kind of evidence to `extraction.ts` without building a check for it is a type error, not
merely a red test. Confirmed by adding a fictional `insurance_valuation` source and watching
`tsc` refuse it before any test ran.

## 2. The gate can say no

Withhold one piece of evidence and the domains that depended on it are refused **by name**:

> `physical_count` withheld → `products, barcodes, prices, stock, batches` refused as
> `verified_by_the_same_system` — *"it would be just as consistent about a wrong number."*

A gate that cannot fail has not been tested.

## 3. The witnesses agree with each other

One shop, one month, six witnesses — with four figures deliberately tied across independent checks:

| Tie | Why it is meaningful |
| --- | --- |
| Bank gross across every tender **=** filed taxable + tax (₹75,86,000) | The bank sees money arriving; the return declares what was sold. Two records, opposite ends, same month |
| Signed accounts *Stock on hand* **=** the counted shelves (₹50,00,000) | The balance sheet figure and the physical count are the same number or one is wrong |
| Signed accounts *Trade creditors* **=** the suppliers' own confirmations (₹30,00,000) | Three suppliers each confirmed their own ledger |
| Signed accounts *GST payable* **=** the filed return (₹2,86,000) | Filed, dated, acknowledged |

**A wrong number now has to be wrong consistently in two independent records to survive.** A test
proves the ties are real rather than decorative: change one day's cash takings by ₹1,00,000 and
*two* checks break — the bank reports more cash lodged than the system says was taken, and the tie
to the filed return fails.

## 4. The verified figures reach an append-only ledger

Each of the four control figures is banked as an event **carrying the witness that proved it**
(`verifiedAgainst: 'physical_count'`, and so on). A number in the opening books whose witness
nobody recorded is a number nobody can defend two years later.

The database then refuses to change them — `UPDATE` and `DELETE` on `event_ledger` both throw
`append-only` (hard rule #2).

## 5. What none of the six will do

An absence check across all six modules: no `selfVerify`, `acceptWithout`, `forceReconcile`,
`assumeCorrect` or `skipVerification` is exported anywhere. The approach rests on there being no
way round the refusals, and that is asserted rather than assumed.

---

## The pattern common to all six

Arrived at independently each time, which is the reason to trust it: **an arithmetic that closes
by naming the hole rather than finding it is refused.**

- A commission rate derived from the difference it explains
- A tax rate averaged across a mixed basket
- A suspense account absorbing the opening difference
- A sample drawn from the customers who already complained
- A control total whose two sides were computed the same way

Each makes the numbers agree perfectly and proves nothing. Each is the move a competent person
makes under time pressure. Each is refused by name, with the reason in plain words.

## What each check does NOT prove

Every module carries a fixed `false` naming its own limit, so none can be read as proving more
than it does:

- `provesSalesWereComplete: false` — the bank shows what arrived. A sale rung up and pocketed
  reaches neither the old system nor the bank, and the two agree perfectly about it.
- `provesTaxWasCorrectlyCharged: false` — a return shows what was declared. Sell at 5% what
  should have been 12% and the books and the return record the same mistake.
- `provesTheAccountsAreRight: false` — the CA prepared them from the same old system. A signature
  and double entry, not an independent source.
- `provesTheBalanceWasEarned: false` — a customer confirms the balance, not that it was earned.
- `certifiesTheTarget: false`, `expectedQtyShownToCounter: false`, `dataIsNeverDeleted: true`

## Related

- `../runbooks/legacy-self-extraction.md` — the procedure, for somebody who is not a programmer
- `ob-06-we-get-it-out-ourselves.md` — the extraction path that feeds this
- `stage-11-the-old-shop-arrives-whole.md` — the MG-01…12 engine underneath
