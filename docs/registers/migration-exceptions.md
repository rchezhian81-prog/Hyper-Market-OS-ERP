# Migration Exception Register

Every record the previous system holds that **cannot be migrated cleanly**, with its value
and its owner. Required by MG-04/MG-06/MG-09 and hard rule #6: **a migration exception is
never deleted**, never quietly rounded away, and never resolved by making a test pass.

**Status: empty and not yet open.** Migration rehearsal is roadmap **Stage 11**; extraction
from the previous system needs AVR-03 (export method and lawful extraction rights). No
exception can exist before the first trial load.

## What gets recorded here

| Column | Meaning |
| --- | --- |
| MEX ID | Stable identifier, never reused |
| Trial | Which trial migration found it (T1, T2, …) |
| Domain | Product, stock, customer, supplier, financial, loyalty, tax |
| Source record | The previous system's key, as extracted |
| Problem | Missing mandatory field, unmappable code, duplicate, out-of-balance, unreadable |
| Quantity / value | **Always valued.** An exception with no number cannot be prioritised or signed off |
| Owner | The named person who must decide |
| Decision | Migrate as-is · Correct at source · Transform with approval · Exclude with owner approval |
| Evidence | Where the raw extract and the decision are retained |
| Status | Open · Decided · Applied · Verified |

## Rules that hold when it does open

1. **Control totals must reconcile** before any load is accepted — row counts, quantities,
   stock value, tax, payments, balances and loyalty points (QG-07). A difference is an
   exception with a value, never a rounding.
2. **Excluding history requires the owner's written approval** with a reason (OD-05/MG-07).
3. **Raw extracts and their hashes are retained immutably** (MG-02) — the register points at
   them; it never replaces them.
4. **Nothing here is deleted**, including after the previous system is retired.

| MEX ID | Trial | Domain | Problem | Value | Owner | Decision | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| _(none yet — opens at Stage 11)_ | | | | | | | |
